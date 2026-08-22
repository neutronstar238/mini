#include <iostream>
#include <map>
int main(){ std::map<int,int> m{{1,2}}; auto [k,v]=*m.begin(); std::cout<<k+v<<"\n"; }
