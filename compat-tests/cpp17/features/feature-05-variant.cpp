#include <iostream>
#include <variant>
int main(){ std::variant<int,std::string> x=std::string("ok"); std::cout<<std::get<std::string>(x)<<"\n"; }
